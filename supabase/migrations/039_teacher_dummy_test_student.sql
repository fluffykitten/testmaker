-- ============================================================================
-- Migration 039: Universal Teacher Test Dummy Student (PIN: 0000, Every Class)
-- ============================================================================
-- Adds built-in support for a reserved teacher test candidate account:
--   Name:  "Teacher Test Account" (also accepts "Teacher Test Student",
--          "Teacher Test", and "Dummy Student")
--   PIN:   "0000"
--   Class: Valid across EVERY school or custom class (all classes)
-- Keeps `app_config('school_roster')`, Desk Cards, and printed PIN sheets
-- completely clean while allowing full end-to-end PIN lobby entry and exam
-- submission testing in any class.
-- ============================================================================

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
    v_clean_name TEXT := LOWER(REGEXP_REPLACE(TRIM(COALESCE(p_name, '')), '\s+', ' ', 'g'));
    v_clean_class TEXT := public.normalize_roster_class_label(p_class);
    v_clean_pin TEXT := TRIM(COALESCE(p_pin, ''));
    v_scope TEXT := 'student_pin:' || v_clean_name || '::' || v_clean_class;
    v_meta RECORD;
    v_entry RECORD;
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

    -- Built-in universal Teacher Test Account (PIN 0000, valid in every class)
    IF v_clean_name IN ('teacher test account', 'teacher test student', 'teacher test', 'dummy student') THEN
        IF v_clean_pin <> '0000' THEN
            PERFORM public.record_rate_limit_failure(v_scope, 10, 600, 600);
            RETURN jsonb_build_object(
                'valid', false,
                'error', 'Incorrect 4-digit PIN for Teacher Test Account. Use test PIN 0000.'
            );
        END IF;

        PERFORM public.clear_rate_limit(v_scope);
        RETURN jsonb_build_object(
            'valid', true,
            'student', jsonb_build_object(
                'id', 'dummy-teacher-test',
                'name', 'Teacher Test Account',
                'class', COALESCE(NULLIF(TRIM(COALESCE(p_class, '')), ''), 'X IPA 1'),
                'candidateNumber', 'TEST00'
            )
        );
    END IF;

    SELECT is_configured, is_corrupt
    INTO v_meta
    FROM public.school_roster_meta
    WHERE singleton_id = 1
    LIMIT 1;

    IF NOT FOUND THEN
        PERFORM public.rebuild_school_roster_cache();
        SELECT is_configured, is_corrupt
        INTO v_meta
        FROM public.school_roster_meta
        WHERE singleton_id = 1
        LIMIT 1;
    END IF;

    IF COALESCE(v_meta.is_corrupt, FALSE) THEN
        RETURN jsonb_build_object('valid', false, 'unconfigured', true, 'error', 'School roster data is invalid or corrupt in database.');
    END IF;

    IF NOT COALESCE(v_meta.is_configured, FALSE) THEN
        RETURN jsonb_build_object('valid', false, 'unconfigured', true, 'error', 'School roster not configured in database.');
    END IF;

    SELECT student_id, student_name, student_class, candidate_number, pin
    INTO v_entry
    FROM public.school_roster_entries
    WHERE norm_name = v_clean_name
      AND (v_clean_class = '' OR norm_class = v_clean_class)
    ORDER BY ord ASC
    LIMIT 1;

    IF NOT FOUND THEN
        PERFORM public.record_rate_limit_failure(v_scope, 10, 600, 600);
        RETURN jsonb_build_object(
            'valid', false,
            'error', 'Candidate "' || TRIM(p_name) || '" was not found in the school roster' ||
                     CASE WHEN v_clean_class <> '' THEN ' for class ' || TRIM(p_class) ELSE '' END ||
                     '. Please check your spelling or verify with your teacher.'
        );
    END IF;

    IF v_entry.pin <> v_clean_pin THEN
        PERFORM public.record_rate_limit_failure(v_scope, 10, 600, 600);
        RETURN jsonb_build_object(
            'valid', false,
            'error', 'Incorrect 4-digit PIN for ' || v_entry.student_name || '. Please verify with your teacher.'
        );
    END IF;

    PERFORM public.clear_rate_limit(v_scope);

    RETURN jsonb_build_object(
        'valid', true,
        'student', jsonb_build_object(
            'id', v_entry.student_id,
            'name', v_entry.student_name,
            'class', v_entry.student_class,
            'candidateNumber', v_entry.candidate_number
        )
    );
END;
$$;

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
    v_clean_name TEXT := LOWER(REGEXP_REPLACE(TRIM(COALESCE(p_student_name, '')), '\s+', ' ', 'g'));
    v_clean_class TEXT := public.normalize_roster_class_label(p_student_class);
    v_clean_pin TEXT := TRIM(COALESCE(p_student_pin, ''));
    v_meta RECORD;
    v_stored_pin TEXT;
BEGIN
    IF v_clean_name = '' THEN
        RETURN NOT p_require_enrolled;
    END IF;

    IF p_require_enrolled AND (v_clean_pin = '' OR LENGTH(v_clean_pin) <> 4) THEN
        RETURN FALSE;
    END IF;

    -- Built-in universal Teacher Test Account (PIN 0000, valid in every class)
    IF v_clean_name IN ('teacher test account', 'teacher test student', 'teacher test', 'dummy student') THEN
        RETURN v_clean_pin = '0000';
    END IF;

    SELECT is_configured, is_corrupt
    INTO v_meta
    FROM public.school_roster_meta
    WHERE singleton_id = 1
    LIMIT 1;

    IF NOT FOUND THEN
        PERFORM public.rebuild_school_roster_cache();
        SELECT is_configured, is_corrupt
        INTO v_meta
        FROM public.school_roster_meta
        WHERE singleton_id = 1
        LIMIT 1;
    END IF;

    IF COALESCE(v_meta.is_corrupt, FALSE) OR NOT COALESCE(v_meta.is_configured, FALSE) THEN
        RETURN NOT p_require_enrolled;
    END IF;

    SELECT pin
    INTO v_stored_pin
    FROM public.school_roster_entries
    WHERE norm_name = v_clean_name
      AND (v_clean_class = '' OR norm_class = '' OR norm_class = v_clean_class)
    ORDER BY ord ASC
    LIMIT 1;

    IF NOT FOUND THEN
        RETURN NOT p_require_enrolled;
    END IF;

    IF COALESCE(v_stored_pin, '') = '' THEN
        RETURN NOT p_require_enrolled;
    END IF;

    RETURN v_stored_pin = v_clean_pin;
END;
$$;

REVOKE ALL ON FUNCTION public.verify_roster_pin_if_enrolled(TEXT, TEXT, TEXT, TEXT, BOOLEAN) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_public_roster_directory() TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.verify_student_pin(TEXT, TEXT, TEXT) TO anon, authenticated;
