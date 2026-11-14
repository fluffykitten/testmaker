-- ============================================================================
-- Migration 021: Phase 2 — Unified Teacher Login, Student Exam RPCs & Strict RLS
-- ============================================================================
-- Prerequisite: Migration 020 (`public.verify_teacher_access_pin`)
-- Safe to re-run (idempotent DDL, CREATE OR REPLACE functions, policy drops).
-- Uses Postgres built-in SHA256 + gen_random_uuid() (no pgcrypto dependency).
-- ============================================================================

-- ─── 2A. Teacher Account Schema & Session Store ──────────────────────────────

ALTER TABLE public.teacher_profiles
    ADD COLUMN IF NOT EXISTS email TEXT,
    ADD COLUMN IF NOT EXISTS username TEXT,
    ADD COLUMN IF NOT EXISTS password_hash TEXT,
    ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'teacher',
    ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE,
    ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ;

CREATE UNIQUE INDEX IF NOT EXISTS idx_teacher_profiles_email_unique
    ON public.teacher_profiles (LOWER(TRIM(email)))
    WHERE email IS NOT NULL AND TRIM(email) <> '';

CREATE UNIQUE INDEX IF NOT EXISTS idx_teacher_profiles_username_unique
    ON public.teacher_profiles (LOWER(TRIM(username)))
    WHERE username IS NOT NULL AND TRIM(username) <> '';

CREATE TABLE IF NOT EXISTS public.teacher_auth_sessions (
    token_hash TEXT PRIMARY KEY,
    teacher_id UUID NOT NULL REFERENCES public.teacher_profiles(id) ON DELETE CASCADE,
    role TEXT NOT NULL DEFAULT 'teacher',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_teacher_auth_sessions_expires
    ON public.teacher_auth_sessions (expires_at);

ALTER TABLE public.teacher_auth_sessions ENABLE ROW LEVEL SECURITY;

-- Strip sensitive hashes before returning a teacher_profiles row to any client
CREATE OR REPLACE FUNCTION public.sanitize_teacher_profile_json(
    p_row public.teacher_profiles
)
RETURNS JSONB
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
    SELECT (to_jsonb(p_row) - 'password_hash' - 'pin_hash')
        || jsonb_build_object(
            'has_password',
            p_row.password_hash IS NOT NULL AND TRIM(p_row.password_hash) <> ''
        );
$$;

-- Validates whether the current request comes from an authenticated Supabase Auth user
-- OR carries a valid, non-expired `x-teacher-session` token in PostgREST request headers.
CREATE OR REPLACE FUNCTION public.is_authenticated_teacher()
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
DECLARE
    v_raw_headers TEXT;
    v_token TEXT;
    v_hash TEXT;
BEGIN
    IF auth.role() = 'authenticated' THEN
        RETURN TRUE;
    END IF;

    v_raw_headers := current_setting('request.headers', true);
    IF v_raw_headers IS NULL OR TRIM(v_raw_headers) = '' THEN
        RETURN FALSE;
    END IF;

    v_token := TRIM(COALESCE((v_raw_headers::jsonb)->>'x-teacher-session', ''));
    IF v_token = '' THEN
        RETURN FALSE;
    END IF;

    v_hash := LOWER(ENCODE(SHA256(CONVERT_TO(v_token, 'UTF8')), 'hex'));

    RETURN EXISTS (
        SELECT 1
        FROM public.teacher_auth_sessions
        WHERE token_hash = v_hash
          AND expires_at > NOW()
    );
EXCEPTION WHEN OTHERS THEN
    RETURN FALSE;
END;
$$;

-- ─── 2B. Teacher Login, Registration, Claim & Password Reset RPCs ────────────

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
        RETURN jsonb_build_object(
            'status', 'invalid_credentials',
            'error', 'Invalid username/email or password.'
        );
    END IF;

    DELETE FROM public.teacher_auth_sessions WHERE expires_at <= NOW();

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
    WHERE id = v_profile.id
    RETURNING * INTO v_profile;

    RETURN jsonb_build_object(
        'status', 'ok',
        'token', v_token,
        'expiresAt', v_expires_at,
        'profile', public.sanitize_teacher_profile_json(v_profile)
    );
END;
$$;

CREATE OR REPLACE FUNCTION public.register_or_claim_teacher_account(
    p_master_pin TEXT,
    p_email TEXT,
    p_username TEXT,
    p_password TEXT,
    p_name TEXT,
    p_title TEXT DEFAULT 'Dr.',
    p_subject TEXT DEFAULT 'Chemistry',
    p_subject_code TEXT DEFAULT '0620',
    p_default_classes TEXT[] DEFAULT ARRAY['10-A', '10-B'],
    p_claim_profile_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_email TEXT := NULLIF(TRIM(COALESCE(p_email, '')), '');
    v_username TEXT := NULLIF(TRIM(COALESCE(p_username, '')), '');
    v_name TEXT := TRIM(COALESCE(p_name, ''));
    v_pw TEXT := COALESCE(p_password, '');
    v_salt TEXT;
    v_pw_hash TEXT;
    v_profile public.teacher_profiles;
    v_token TEXT;
    v_token_hash TEXT;
    v_expires_at TIMESTAMPTZ := NOW() + INTERVAL '12 hours';
    v_claiming_enabled BOOLEAN := FALSE;
BEGIN
    SELECT LOWER(TRIM(COALESCE(value, 'false'))) IN ('true', '1', 'yes')
    INTO v_claiming_enabled
    FROM public.app_config
    WHERE key = 'allow_teacher_account_claiming'
    LIMIT 1;

    IF NOT COALESCE(v_claiming_enabled, FALSE) THEN
        RETURN jsonb_build_object(
            'status', 'error',
            'error', 'Educator account creation and profile claiming are currently disabled by the administrator.'
        );
    END IF;

    IF NOT public.verify_teacher_access_pin(p_master_pin) THEN
        RETURN jsonb_build_object(
            'status', 'error',
            'error', 'Invalid 6-digit School Master PIN.'
        );
    END IF;

    IF LENGTH(TRIM(v_pw)) < 6 THEN
        RETURN jsonb_build_object(
            'status', 'error',
            'error', 'Password must be at least 6 characters.'
        );
    END IF;

    IF v_username IS NULL AND v_email IS NULL THEN
        RETURN jsonb_build_object(
            'status', 'error',
            'error', 'Please enter a username or email address.'
        );
    END IF;

    IF v_name = '' THEN
        RETURN jsonb_build_object(
            'status', 'error',
            'error', 'Please enter your full display name.'
        );
    END IF;

    v_salt := SUBSTRING(
        LOWER(ENCODE(SHA256(CONVERT_TO(gen_random_uuid()::text || '::' || clock_timestamp()::text, 'UTF8')), 'hex'))
        FROM 1 FOR 16
    );
    v_pw_hash := v_salt || ':' || LOWER(ENCODE(SHA256(CONVERT_TO(v_salt || '::' || v_pw, 'UTF8')), 'hex'));

    IF p_claim_profile_id IS NOT NULL THEN
        UPDATE public.teacher_profiles
        SET email = COALESCE(v_email, email),
            username = COALESCE(v_username, username),
            password_hash = v_pw_hash,
            name = v_name,
            title = NULLIF(TRIM(COALESCE(p_title, '')), ''),
            subject = COALESCE(NULLIF(TRIM(p_subject), ''), subject, 'Chemistry'),
            subject_code = COALESCE(NULLIF(TRIM(p_subject_code), ''), subject_code, '0620'),
            default_classes = CASE
                WHEN p_default_classes IS NOT NULL AND array_length(p_default_classes, 1) > 0 THEN p_default_classes
                ELSE default_classes
            END,
            is_active = TRUE,
            last_login_at = NOW(),
            updated_at = NOW()
        WHERE id = p_claim_profile_id
          AND (password_hash IS NULL OR TRIM(password_hash) = '')
        RETURNING * INTO v_profile;

        IF NOT FOUND THEN
            RETURN jsonb_build_object(
                'status', 'error',
                'error', 'This educator profile does not exist or has already been claimed.'
            );
        END IF;
    ELSE
        INSERT INTO public.teacher_profiles (
            name,
            title,
            email,
            username,
            password_hash,
            subject,
            subject_code,
            default_classes,
            role,
            is_active,
            last_login_at
        )
        VALUES (
            v_name,
            COALESCE(NULLIF(TRIM(p_title), ''), 'Dr.'),
            v_email,
            v_username,
            v_pw_hash,
            COALESCE(NULLIF(TRIM(p_subject), ''), 'Chemistry'),
            COALESCE(NULLIF(TRIM(p_subject_code), ''), '0620'),
            COALESCE(p_default_classes, ARRAY['10-A', '10-B']),
            'teacher',
            TRUE,
            NOW()
        )
        RETURNING * INTO v_profile;
    END IF;

    DELETE FROM public.teacher_auth_sessions WHERE expires_at <= NOW();

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
EXCEPTION
    WHEN unique_violation THEN
        RETURN jsonb_build_object(
            'status', 'error',
            'error', 'An educator account with that email or username already exists.'
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
    v_salt TEXT;
    v_pw_hash TEXT;
    v_profile public.teacher_profiles;
    v_token TEXT;
    v_token_hash TEXT;
    v_expires_at TIMESTAMPTZ := NOW() + INTERVAL '12 hours';
BEGIN
    IF NOT public.verify_teacher_access_pin(p_master_pin) THEN
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
        RETURN jsonb_build_object(
            'status', 'error',
            'error', 'No active educator account matched that email or username.'
        );
    END IF;

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

CREATE OR REPLACE FUNCTION public.logout_teacher_session()
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_raw_headers TEXT;
    v_token TEXT;
    v_hash TEXT;
BEGIN
    v_raw_headers := current_setting('request.headers', true);
    IF v_raw_headers IS NULL OR TRIM(v_raw_headers) = '' THEN
        RETURN FALSE;
    END IF;

    v_token := TRIM(COALESCE((v_raw_headers::jsonb)->>'x-teacher-session', ''));
    IF v_token = '' THEN
        RETURN FALSE;
    END IF;

    v_hash := LOWER(ENCODE(SHA256(CONVERT_TO(v_token, 'UTF8')), 'hex'));
    DELETE FROM public.teacher_auth_sessions WHERE token_hash = v_hash;
    RETURN TRUE;
EXCEPTION WHEN OTHERS THEN
    RETURN FALSE;
END;
$$;

-- ─── 2C. Server-Side Student Exam Delivery, Draft & Submission RPCs ──────────

-- Helper to strip `expected_answer` and `expectedAnswers` inside fillable data tables
CREATE OR REPLACE FUNCTION public.strip_data_tables_expected_answers(
    p_tables JSONB
)
RETURNS JSONB
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
    SELECT CASE
        WHEN p_tables IS NULL OR jsonb_typeof(p_tables) <> 'array' THEN p_tables
        ELSE COALESCE((
            SELECT jsonb_agg(
                CASE
                    WHEN jsonb_typeof(tbl) = 'object' AND jsonb_typeof(tbl->'rows') = 'array' THEN
                        tbl || jsonb_build_object(
                            'rows',
                            COALESCE((
                                SELECT jsonb_agg(
                                    CASE
                                        WHEN jsonb_typeof(r) = 'array' THEN
                                            COALESCE((
                                                SELECT jsonb_agg(
                                                    CASE
                                                        WHEN jsonb_typeof(c) = 'object' THEN c - 'expected_answer' - 'expectedAnswers'
                                                        ELSE c
                                                    END
                                                )
                                                FROM jsonb_array_elements(r) c
                                            ), '[]'::jsonb)
                                        ELSE r
                                    END
                                )
                                FROM jsonb_array_elements(tbl->'rows') r
                            ), '[]'::jsonb)
                        )
                    ELSE tbl
                END
            )
            FROM jsonb_array_elements(p_tables) tbl
        ), '[]'::jsonb)
    END;
$$;

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

    -- Preserve non-answer insert resources from either top-level or mark_scheme._insert_resources
    IF jsonb_typeof(v_q->'insert_resources') = 'array' AND jsonb_array_length(v_q->'insert_resources') > 0 THEN
        v_insert_res := v_q->'insert_resources';
    ELSIF jsonb_typeof(v_q->'mark_scheme'->'_insert_resources') = 'array' AND jsonb_array_length(v_q->'mark_scheme'->'_insert_resources') > 0 THEN
        v_insert_res := v_q->'mark_scheme'->'_insert_resources';
    ELSE
        v_insert_res := NULL;
    END IF;

    -- Preserve structural data tables from either top-level or mark_scheme._data_tables (answers stripped)
    IF jsonb_typeof(v_q->'data_tables') = 'array' AND jsonb_array_length(v_q->'data_tables') > 0 THEN
        v_data_tables := public.strip_data_tables_expected_answers(v_q->'data_tables');
    ELSIF jsonb_typeof(v_q->'mark_scheme'->'_data_tables') = 'array' AND jsonb_array_length(v_q->'mark_scheme'->'_data_tables') > 0 THEN
        v_data_tables := public.strip_data_tables_expected_answers(v_q->'mark_scheme'->'_data_tables');
    ELSE
        v_data_tables := NULL;
    END IF;

    -- Sanitize nested sub_questions
    IF jsonb_typeof(v_q->'sub_questions') = 'array' THEN
        SELECT COALESCE(jsonb_agg(
            CASE
                WHEN jsonb_typeof(sq) = 'object' THEN
                    (
                        sq - 'mark_scheme' - 'guidance' - 'common_misconceptions' - 'acceptable_answers'
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
        v_q - 'scratchpad' - 'guidance' - 'common_misconceptions' - 'acceptable_answers' - 'source_pdf_url' - 'metadata'
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
    v_qid TEXT;
    v_q_row public.questions;
    v_q_json JSONB;
    v_override JSONB;
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

    -- Build ordered sanitized questions array
    IF v_qids IS NOT NULL AND array_length(v_qids, 1) > 0 THEN
        FOREACH v_qid IN ARRAY v_qids
        LOOP
            v_override := CASE WHEN v_overrides ? v_qid THEN v_overrides->v_qid ELSE NULL END;
            v_q_json := NULL;

            IF v_qid ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
                SELECT * INTO v_q_row FROM public.questions WHERE id = v_qid::uuid LIMIT 1;
                IF FOUND THEN
                    v_q_json := to_jsonb(v_q_row);
                END IF;
            END IF;

            IF v_override IS NOT NULL AND jsonb_typeof(v_override) = 'object' THEN
                v_q_json := COALESCE(v_q_json, '{}'::jsonb) || v_override;
            END IF;

            IF v_q_json IS NOT NULL THEN
                v_questions := v_questions || jsonb_build_array(
                    public.sanitize_question_json_for_student(v_q_json, v_strip_keys)
                );
            END IF;
        END LOOP;
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

-- Student cloud exam draft RPCs (strictly scoped to draft_* keys)
CREATE OR REPLACE FUNCTION public.save_student_exam_draft(
    p_key TEXT,
    p_value TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    IF p_key IS NULL OR p_key NOT LIKE 'draft_%' OR LENGTH(p_key) > 180 THEN
        RETURN FALSE;
    END IF;

    INSERT INTO public.app_config (key, value, updated_at)
    VALUES (p_key, COALESCE(p_value, ''), NOW())
    ON CONFLICT (key) DO UPDATE
    SET value = EXCLUDED.value,
        updated_at = NOW();

    RETURN TRUE;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_student_exam_draft(
    p_key TEXT
)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
DECLARE
    v_val TEXT;
BEGIN
    IF p_key IS NULL OR p_key NOT LIKE 'draft_%' OR LENGTH(p_key) > 180 THEN
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
    p_key TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    IF p_key IS NULL OR p_key NOT LIKE 'draft_%' OR LENGTH(p_key) > 180 THEN
        RETURN FALSE;
    END IF;

    DELETE FROM public.app_config WHERE key = p_key;
    RETURN TRUE;
END;
$$;

-- Student exam submission RPC (forces initial 'submitted' state & blocks tampering with graded/published rows)
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
    v_result_pin TEXT := COALESCE(p_row->>'result_pin', '');
BEGIN
    IF p_row IS NULL OR v_id = '' OR v_quiz_code = '' THEN
        RETURN FALSE;
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
        p_row->>'quiz_title',
        p_row->>'subject',
        v_student_name,
        p_row->>'student_class',
        p_row->>'candidate_number',
        COALESCE(NULLIF(p_row->>'submitted_at', '')::timestamptz, NOW()),
        COALESCE(NULLIF(p_row->>'duration_seconds', '')::int, 0),
        COALESCE(NULLIF(p_row->>'score', '')::numeric, 0),
        COALESCE(NULLIF(p_row->>'total_marks', '')::numeric, 0),
        COALESCE(NULLIF(p_row->>'percentage', '')::numeric, 0),
        COALESCE(NULLIF(p_row->>'violations_count', '')::int, 0),
        COALESCE(p_row->'proctoring_logs', '[]'::jsonb),
        COALESCE(p_row->'raw_answers', '{}'::jsonb),
        COALESCE(p_row->'question_results', '[]'::jsonb),
        COALESCE(p_row->'topic_breakdown', '{}'::jsonb),
        'submitted',
        0,
        COALESCE(p_row->>'teacher_notes', ''),
        v_result_pin,
        COALESCE(NULLIF(p_row->>'updated_at', '')::timestamptz, NOW())
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
        result_pin = EXCLUDED.result_pin,
        updated_at = EXCLUDED.updated_at
    WHERE public.quiz_submissions.status = 'submitted'
      AND (
          COALESCE(public.quiz_submissions.result_pin, '') = ''
          OR public.quiz_submissions.result_pin = COALESCE(p_row->>'result_pin', '')
      );

    RETURN TRUE;
EXCEPTION WHEN OTHERS THEN
    RETURN FALSE;
END;
$$;

-- Upgrade scoped result lookup from Migration 019 to enforce allowStudentScriptDownload
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
            'hasUnreleased', FALSE
        );
    END IF;

    -- Determine allowStudentScriptDownload flag from app_config
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

-- ─── 2D. Enable Strict RLS Across All Workspace Tables ───────────────────────

-- Drop every existing policy on all 7 workspace tables cleanly
DO $$
DECLARE
    v_pol RECORD;
BEGIN
    FOR v_pol IN
        SELECT schemaname, tablename, policyname
        FROM pg_policies
        WHERE schemaname = 'public'
          AND tablename IN (
              'syllabuses',
              'questions',
              'custom_tests',
              'app_config',
              'quiz_submissions',
              'teacher_profiles',
              'proctor_audit_events'
          )
    LOOP
        EXECUTE format(
            'DROP POLICY IF EXISTS %I ON %I.%I',
            v_pol.policyname,
            v_pol.schemaname,
            v_pol.tablename
        );
    END LOOP;
END $$;

ALTER TABLE public.syllabuses ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.questions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.custom_tests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.app_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.quiz_submissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.teacher_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.proctor_audit_events ENABLE ROW LEVEL SECURITY;

-- Teacher-only full access on core exam, submission, syllabus, and educator tables
CREATE POLICY "Teacher full access syllabuses"
    ON public.syllabuses FOR ALL
    USING (public.is_authenticated_teacher())
    WITH CHECK (public.is_authenticated_teacher());

CREATE POLICY "Teacher full access questions"
    ON public.questions FOR ALL
    USING (public.is_authenticated_teacher())
    WITH CHECK (public.is_authenticated_teacher());

CREATE POLICY "Teacher full access custom_tests"
    ON public.custom_tests FOR ALL
    USING (public.is_authenticated_teacher())
    WITH CHECK (public.is_authenticated_teacher());

CREATE POLICY "Teacher full access quiz_submissions"
    ON public.quiz_submissions FOR ALL
    USING (public.is_authenticated_teacher())
    WITH CHECK (public.is_authenticated_teacher());

CREATE POLICY "Teacher full access teacher_profiles"
    ON public.teacher_profiles FOR ALL
    USING (public.is_authenticated_teacher())
    WITH CHECK (public.is_authenticated_teacher());

-- app_config: full access for authenticated teachers; anon SELECT strictly limited to 8 public UI settings
CREATE POLICY "Teacher full access app_config"
    ON public.app_config FOR ALL
    USING (public.is_authenticated_teacher())
    WITH CHECK (public.is_authenticated_teacher());

CREATE POLICY "Public read non-sensitive ui app_config"
    ON public.app_config FOR SELECT
    USING (
        key IN (
            'school_classes',
            'school_subjects',
            'google_drive_client_id',
            'hide_creative_mode_landing',
            'hide_emergency_exam_button',
            'gemini_extraction_model',
            'gemini_api_key_tier',
            'exam_security_tiers',
            'allow_teacher_account_claiming'
        )
    );

-- proctor_audit_events: teachers can read/manage all rows; student browsers can only insert student audit logs
CREATE POLICY "Teacher full access proctor_audit_events"
    ON public.proctor_audit_events FOR ALL
    USING (public.is_authenticated_teacher())
    WITH CHECK (public.is_authenticated_teacher());

CREATE POLICY "Student insert audit events only"
    ON public.proctor_audit_events FOR INSERT
    WITH CHECK (actor = 'student');

-- ─── Permissions for PostgREST RPC Calls ─────────────────────────────────────

REVOKE ALL ON public.teacher_auth_sessions FROM anon, authenticated;

GRANT EXECUTE ON FUNCTION public.is_authenticated_teacher() TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.login_teacher_account(TEXT, TEXT) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.register_or_claim_teacher_account(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT[], UUID) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reset_teacher_password_with_master_pin(TEXT, TEXT, TEXT) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.logout_teacher_session() TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_student_exam_paper(TEXT) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.save_student_exam_draft(TEXT, TEXT) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_student_exam_draft(TEXT) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.delete_student_exam_draft(TEXT) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.submit_student_exam_attempt(JSONB) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.lookup_student_exam_result(TEXT, TEXT, TEXT) TO anon, authenticated;

COMMENT ON TABLE public.teacher_auth_sessions IS 'Hashed 12-hour educator session tokens validated via x-teacher-session header.';
COMMENT ON FUNCTION public.is_authenticated_teacher() IS 'Validates Supabase authenticated role or active x-teacher-session header for RLS.';
COMMENT ON FUNCTION public.get_student_exam_paper(TEXT) IS 'Phase 2: Returns active student exam paper with server-side answer-key and metadata sanitization.';

