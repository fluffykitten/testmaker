-- ============================================================================
-- Migration 026: Admin Educator Account Management & Password Lifecycle RPCs
-- ============================================================================
-- Adds centralized Admin CRUD & password reset RPCs for `public.teacher_profiles`
-- plus self-service `change_own_teacher_password` and `must_change_password`
-- enforcement for temporary passwords.
-- ============================================================================

-- ─── 1. Schema Extension & Sanitizer Update ──────────────────────────────────

ALTER TABLE public.teacher_profiles
    ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN NOT NULL DEFAULT FALSE;

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
            p_row.password_hash IS NOT NULL AND TRIM(p_row.password_hash) <> '',
            'is_active',
            COALESCE(p_row.is_active, TRUE),
            'must_change_password',
            COALESCE(p_row.must_change_password, FALSE)
        );
$$;

-- ─── 2. Session & Admin Authorization Helpers ────────────────────────────────

CREATE OR REPLACE FUNCTION public.get_authenticated_teacher_id()
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
DECLARE
    v_raw_headers TEXT;
    v_token TEXT;
    v_hash TEXT;
    v_teacher_id UUID;
BEGIN
    v_raw_headers := current_setting('request.headers', true);
    IF v_raw_headers IS NULL OR TRIM(v_raw_headers) = '' THEN
        RETURN NULL;
    END IF;

    v_token := TRIM(COALESCE((v_raw_headers::jsonb)->>'x-teacher-session', ''));
    IF v_token = '' THEN
        RETURN NULL;
    END IF;

    v_hash := LOWER(ENCODE(SHA256(CONVERT_TO(v_token, 'UTF8')), 'hex'));

    SELECT s.teacher_id
    INTO v_teacher_id
    FROM public.teacher_auth_sessions s
    JOIN public.teacher_profiles p ON p.id = s.teacher_id
    WHERE s.token_hash = v_hash
      AND s.expires_at > NOW()
      AND p.is_active = TRUE
    LIMIT 1;

    RETURN v_teacher_id;
EXCEPTION WHEN OTHERS THEN
    RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.is_admin_or_master_pin(
    p_master_pin TEXT DEFAULT NULL
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_teacher_id UUID;
    v_role TEXT;
BEGIN
    v_teacher_id := public.get_authenticated_teacher_id();
    IF v_teacher_id IS NOT NULL THEN
        SELECT LOWER(TRIM(COALESCE(role, 'teacher')))
        INTO v_role
        FROM public.teacher_profiles
        WHERE id = v_teacher_id
          AND is_active = TRUE
        LIMIT 1;

        IF v_role = 'admin' THEN
            RETURN TRUE;
        END IF;

        -- Bootstrap mode: if no active admin account has been designated yet,
        -- allow any active authenticated educator session to manage accounts & promote an admin.
        IF NOT EXISTS (
            SELECT 1
            FROM public.teacher_profiles
            WHERE LOWER(TRIM(COALESCE(role, 'teacher'))) = 'admin'
              AND is_active = TRUE
        ) THEN
            RETURN TRUE;
        END IF;
    END IF;

    IF p_master_pin IS NOT NULL AND TRIM(p_master_pin) <> '' THEN
        RETURN public.verify_teacher_access_pin(p_master_pin);
    END IF;

    RETURN FALSE;
EXCEPTION WHEN OTHERS THEN
    RETURN FALSE;
END;
$$;

-- ─── 3. Admin Educator Account Management RPCs ───────────────────────────────

CREATE OR REPLACE FUNCTION public.admin_list_teacher_accounts(
    p_master_pin TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_profiles JSONB;
BEGIN
    IF NOT public.is_admin_or_master_pin(p_master_pin) THEN
        RETURN jsonb_build_object(
            'status', 'error',
            'error', 'Unauthorized: Valid 6-digit School Master PIN or Admin account required.'
        );
    END IF;

    SELECT COALESCE(
        jsonb_agg(public.sanitize_teacher_profile_json(tp) ORDER BY tp.created_at ASC),
        '[]'::jsonb
    )
    INTO v_profiles
    FROM public.teacher_profiles tp;

    RETURN jsonb_build_object(
        'status', 'ok',
        'profiles', v_profiles
    );
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_create_teacher_account(
    p_master_pin TEXT,
    p_name TEXT,
    p_title TEXT DEFAULT 'Dr.',
    p_email TEXT DEFAULT NULL,
    p_username TEXT DEFAULT NULL,
    p_password TEXT DEFAULT NULL,
    p_role TEXT DEFAULT 'teacher',
    p_subject TEXT DEFAULT 'Chemistry',
    p_subject_code TEXT DEFAULT '0620',
    p_default_classes TEXT[] DEFAULT ARRAY['10-A', '10-B'],
    p_must_change_password BOOLEAN DEFAULT TRUE
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_name TEXT := TRIM(COALESCE(p_name, ''));
    v_email TEXT := NULLIF(LOWER(TRIM(COALESCE(p_email, ''))), '');
    v_username TEXT := NULLIF(LOWER(TRIM(COALESCE(p_username, ''))), '');
    v_pw TEXT := COALESCE(p_password, '');
    v_role TEXT := CASE WHEN LOWER(TRIM(COALESCE(p_role, ''))) = 'admin' THEN 'admin' ELSE 'teacher' END;
    v_salt TEXT;
    v_pw_hash TEXT;
    v_profile public.teacher_profiles;
BEGIN
    IF NOT public.is_admin_or_master_pin(p_master_pin) THEN
        RETURN jsonb_build_object(
            'status', 'error',
            'error', 'Unauthorized: Valid 6-digit School Master PIN or Admin account required.'
        );
    END IF;

    IF v_name = '' THEN
        RETURN jsonb_build_object(
            'status', 'error',
            'error', 'Educator full display name is required.'
        );
    END IF;

    IF v_username IS NULL AND v_email IS NULL THEN
        RETURN jsonb_build_object(
            'status', 'error',
            'error', 'Please provide a username or school email address.'
        );
    END IF;

    IF LENGTH(TRIM(v_pw)) < 6 THEN
        RETURN jsonb_build_object(
            'status', 'error',
            'error', 'Initial password must be at least 6 characters.'
        );
    END IF;

    v_salt := SUBSTRING(
        LOWER(ENCODE(SHA256(CONVERT_TO(gen_random_uuid()::text || '::' || clock_timestamp()::text, 'UTF8')), 'hex'))
        FROM 1 FOR 16
    );
    v_pw_hash := v_salt || ':' || LOWER(ENCODE(SHA256(CONVERT_TO(v_salt || '::' || v_pw, 'UTF8')), 'hex'));

    INSERT INTO public.teacher_profiles (
        name,
        title,
        email,
        username,
        password_hash,
        role,
        subject,
        subject_code,
        default_classes,
        is_active,
        must_change_password,
        created_at,
        updated_at
    )
    VALUES (
        v_name,
        COALESCE(NULLIF(TRIM(p_title), ''), 'Dr.'),
        v_email,
        v_username,
        v_pw_hash,
        v_role,
        COALESCE(NULLIF(TRIM(p_subject), ''), 'Chemistry'),
        COALESCE(NULLIF(TRIM(p_subject_code), ''), ''),
        CASE
            WHEN p_default_classes IS NOT NULL AND array_length(p_default_classes, 1) > 0 THEN p_default_classes
            ELSE ARRAY['10-A', '10-B']
        END,
        TRUE,
        COALESCE(p_must_change_password, TRUE),
        NOW(),
        NOW()
    )
    RETURNING * INTO v_profile;

    RETURN jsonb_build_object(
        'status', 'ok',
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

CREATE OR REPLACE FUNCTION public.admin_update_teacher_account(
    p_master_pin TEXT,
    p_teacher_id UUID,
    p_name TEXT DEFAULT NULL,
    p_title TEXT DEFAULT NULL,
    p_email TEXT DEFAULT NULL,
    p_username TEXT DEFAULT NULL,
    p_role TEXT DEFAULT NULL,
    p_subject TEXT DEFAULT NULL,
    p_subject_code TEXT DEFAULT NULL,
    p_default_classes TEXT[] DEFAULT NULL,
    p_is_active BOOLEAN DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_existing public.teacher_profiles;
    v_updated public.teacher_profiles;
    v_next_role TEXT;
BEGIN
    IF NOT public.is_admin_or_master_pin(p_master_pin) THEN
        RETURN jsonb_build_object(
            'status', 'error',
            'error', 'Unauthorized: Valid 6-digit School Master PIN or Admin account required.'
        );
    END IF;

    SELECT * INTO v_existing
    FROM public.teacher_profiles
    WHERE id = p_teacher_id
    LIMIT 1;

    IF NOT FOUND THEN
        RETURN jsonb_build_object(
            'status', 'error',
            'error', 'Educator account not found.'
        );
    END IF;

    v_next_role := CASE
        WHEN p_role IS NULL OR TRIM(p_role) = '' THEN v_existing.role
        WHEN LOWER(TRIM(p_role)) = 'admin' THEN 'admin'
        ELSE 'teacher'
    END;

    UPDATE public.teacher_profiles
    SET name = COALESCE(NULLIF(TRIM(p_name), ''), name),
        title = CASE WHEN p_title IS NULL THEN title ELSE NULLIF(TRIM(p_title), '') END,
        email = CASE WHEN p_email IS NULL THEN email ELSE NULLIF(LOWER(TRIM(p_email)), '') END,
        username = CASE WHEN p_username IS NULL THEN username ELSE NULLIF(LOWER(TRIM(p_username)), '') END,
        role = v_next_role,
        subject = COALESCE(NULLIF(TRIM(p_subject), ''), subject),
        subject_code = CASE WHEN p_subject_code IS NULL THEN subject_code ELSE TRIM(p_subject_code) END,
        default_classes = CASE
            WHEN p_default_classes IS NOT NULL AND array_length(p_default_classes, 1) > 0 THEN p_default_classes
            ELSE default_classes
        END,
        is_active = COALESCE(p_is_active, is_active),
        updated_at = NOW()
    WHERE id = p_teacher_id
    RETURNING * INTO v_updated;

    IF COALESCE(v_updated.is_active, TRUE) = FALSE THEN
        DELETE FROM public.teacher_auth_sessions
        WHERE teacher_id = p_teacher_id;
    ELSE
        UPDATE public.teacher_auth_sessions
        SET role = v_next_role
        WHERE teacher_id = p_teacher_id;
    END IF;

    RETURN jsonb_build_object(
        'status', 'ok',
        'profile', public.sanitize_teacher_profile_json(v_updated)
    );
EXCEPTION
    WHEN unique_violation THEN
        RETURN jsonb_build_object(
            'status', 'error',
            'error', 'Another educator account already uses that email or username.'
        );
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_reset_teacher_password(
    p_master_pin TEXT,
    p_teacher_id UUID,
    p_new_password TEXT,
    p_must_change_password BOOLEAN DEFAULT TRUE
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_pw TEXT := COALESCE(p_new_password, '');
    v_salt TEXT;
    v_pw_hash TEXT;
    v_updated public.teacher_profiles;
BEGIN
    IF NOT public.is_admin_or_master_pin(p_master_pin) THEN
        RETURN jsonb_build_object(
            'status', 'error',
            'error', 'Unauthorized: Valid 6-digit School Master PIN or Admin account required.'
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
        must_change_password = COALESCE(p_must_change_password, TRUE),
        is_active = TRUE,
        updated_at = NOW()
    WHERE id = p_teacher_id
    RETURNING * INTO v_updated;

    IF NOT FOUND THEN
        RETURN jsonb_build_object(
            'status', 'error',
            'error', 'Educator account not found.'
        );
    END IF;

    DELETE FROM public.teacher_auth_sessions
    WHERE teacher_id = p_teacher_id;

    RETURN jsonb_build_object(
        'status', 'ok',
        'profile', public.sanitize_teacher_profile_json(v_updated)
    );
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_delete_teacher_account(
    p_master_pin TEXT,
    p_teacher_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_caller_id UUID;
BEGIN
    IF NOT public.is_admin_or_master_pin(p_master_pin) THEN
        RETURN jsonb_build_object(
            'status', 'error',
            'error', 'Unauthorized: Valid 6-digit School Master PIN or Admin account required.'
        );
    END IF;

    v_caller_id := public.get_authenticated_teacher_id();
    IF v_caller_id IS NOT NULL AND v_caller_id = p_teacher_id THEN
        RETURN jsonb_build_object(
            'status', 'error',
            'error', 'You cannot delete the educator account you are currently signed in with.'
        );
    END IF;

    DELETE FROM public.teacher_auth_sessions
    WHERE teacher_id = p_teacher_id;

    DELETE FROM public.teacher_profiles
    WHERE id = p_teacher_id;

    IF NOT FOUND THEN
        RETURN jsonb_build_object(
            'status', 'error',
            'error', 'Educator account not found.'
        );
    END IF;

    RETURN jsonb_build_object(
        'status', 'ok',
        'deletedId', p_teacher_id
    );
END;
$$;

-- ─── 4. Self-Service Educator Password Change RPC ────────────────────────────

CREATE OR REPLACE FUNCTION public.change_own_teacher_password(
    p_current_password TEXT,
    p_new_password TEXT,
    p_teacher_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_session_teacher_id UUID;
    v_target_id UUID;
    v_profile public.teacher_profiles;
    v_stored TEXT;
    v_salt TEXT;
    v_expected_hex TEXT;
    v_candidate_hex TEXT;
    v_new_pw TEXT := COALESCE(p_new_password, '');
    v_curr_pw TEXT := COALESCE(p_current_password, '');
    v_new_salt TEXT;
    v_new_hash TEXT;
    v_scope TEXT;
BEGIN
    v_session_teacher_id := public.get_authenticated_teacher_id();
    IF v_session_teacher_id IS NULL THEN
        RETURN jsonb_build_object(
            'status', 'error',
            'error', 'Your educator session has expired. Please sign in again.'
        );
    END IF;

    IF p_teacher_id IS NOT NULL AND p_teacher_id <> v_session_teacher_id THEN
        RETURN jsonb_build_object(
            'status', 'error',
            'error', 'You can only change the password for your own signed-in account.'
        );
    END IF;

    v_target_id := v_session_teacher_id;
    v_scope := 'teacher_pw_change:' || v_target_id::text;

    IF NOT public.check_rate_limit(v_scope, 6, 600) THEN
        RETURN jsonb_build_object(
            'status', 'error',
            'error', 'Too many failed password attempts. Please wait 10 minutes before trying again.'
        );
    END IF;

    IF LENGTH(TRIM(v_new_pw)) < 6 THEN
        RETURN jsonb_build_object(
            'status', 'error',
            'error', 'New password must be at least 6 characters.'
        );
    END IF;

    SELECT * INTO v_profile
    FROM public.teacher_profiles
    WHERE id = v_target_id
      AND is_active = TRUE
    LIMIT 1;

    IF NOT FOUND THEN
        RETURN jsonb_build_object(
            'status', 'error',
            'error', 'Active educator profile not found.'
        );
    END IF;

    v_stored := TRIM(COALESCE(v_profile.password_hash, ''));
    IF v_stored <> '' THEN
        IF v_curr_pw = '' THEN
            PERFORM public.record_rate_limit_failure(v_scope, 6, 600, 600);
            RETURN jsonb_build_object(
                'status', 'error',
                'error', 'Please enter your current password.'
            );
        END IF;

        IF POSITION(':' IN v_stored) > 0 THEN
            v_salt := SPLIT_PART(v_stored, ':', 1);
            v_expected_hex := LOWER(SPLIT_PART(v_stored, ':', 2));
            v_candidate_hex := LOWER(ENCODE(SHA256(CONVERT_TO(v_salt || '::' || v_curr_pw, 'UTF8')), 'hex'));
        ELSE
            v_expected_hex := LOWER(v_stored);
            v_candidate_hex := LOWER(ENCODE(SHA256(CONVERT_TO(v_curr_pw, 'UTF8')), 'hex'));
        END IF;

        IF v_candidate_hex <> v_expected_hex THEN
            PERFORM public.record_rate_limit_failure(v_scope, 6, 600, 600);
            RETURN jsonb_build_object(
                'status', 'error',
                'error', 'Current password is incorrect.'
            );
        END IF;
    END IF;

    PERFORM public.clear_rate_limit(v_scope);

    v_new_salt := SUBSTRING(
        LOWER(ENCODE(SHA256(CONVERT_TO(gen_random_uuid()::text || '::' || clock_timestamp()::text, 'UTF8')), 'hex'))
        FROM 1 FOR 16
    );
    v_new_hash := v_new_salt || ':' || LOWER(ENCODE(SHA256(CONVERT_TO(v_new_salt || '::' || v_new_pw, 'UTF8')), 'hex'));

    UPDATE public.teacher_profiles
    SET password_hash = v_new_hash,
        must_change_password = FALSE,
        updated_at = NOW()
    WHERE id = v_target_id
    RETURNING * INTO v_profile;

    RETURN jsonb_build_object(
        'status', 'ok',
        'profile', public.sanitize_teacher_profile_json(v_profile)
    );
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_authenticated_teacher_id() TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.is_admin_or_master_pin(TEXT) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_list_teacher_accounts(TEXT) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_create_teacher_account(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT[], BOOLEAN) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_update_teacher_account(TEXT, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT[], BOOLEAN) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_reset_teacher_password(TEXT, UUID, TEXT, BOOLEAN) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_delete_teacher_account(TEXT, UUID) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.change_own_teacher_password(TEXT, TEXT, UUID) TO anon, authenticated;
