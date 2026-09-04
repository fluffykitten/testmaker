-- ============================================================================
-- Migration 010: Server-side PIN verification and sanitized student roster
-- Run this in your Supabase SQL Editor (Dashboard → SQL Editor → New Query)
-- ============================================================================

-- 1. Function to verify a student PIN against app_config school_roster without exposing the roster
CREATE OR REPLACE FUNCTION verify_student_pin(
    p_name TEXT,
    p_class TEXT DEFAULT NULL,
    p_pin TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_roster_json TEXT;
    v_clean_name TEXT := LOWER(REGEXP_REPLACE(TRIM(COALESCE(p_name, '')), '\s+', ' ', 'g'));
    v_clean_class TEXT := LOWER(REGEXP_REPLACE(TRIM(COALESCE(p_class, '')), '\s+', ' ', 'g'));
    v_clean_pin TEXT := TRIM(COALESCE(p_pin, ''));
    v_matched JSONB := NULL;
BEGIN
    -- 1. Validate inputs
    IF v_clean_name = '' THEN
        RETURN jsonb_build_object('valid', false, 'error', 'Candidate full name is required.');
    END IF;

    IF v_clean_pin = '' OR LENGTH(v_clean_pin) <> 4 THEN
        RETURN jsonb_build_object('valid', false, 'error', 'Please enter a valid 4-digit PIN.');
    END IF;

    -- 2. Fetch the roster from app_config
    SELECT value INTO v_roster_json FROM app_config WHERE key = 'school_roster' LIMIT 1;
    IF v_roster_json IS NULL OR v_roster_json = '' OR v_roster_json = '[]' THEN
        RETURN jsonb_build_object('valid', false, 'unconfigured', true, 'error', 'School roster not configured in database.');
    END IF;

    -- 3. Match candidate in the JSON array (Safe parsing with exception block)
    BEGIN
        SELECT elem INTO v_matched
        FROM jsonb_array_elements(v_roster_json::jsonb) AS elem
        WHERE LOWER(REGEXP_REPLACE(TRIM(COALESCE(elem->>'name', '')), '\s+', ' ', 'g')) = v_clean_name
          AND (v_clean_class = '' OR LOWER(REGEXP_REPLACE(TRIM(COALESCE(elem->>'class', '')), '\s+', ' ', 'g')) = v_clean_class)
        LIMIT 1;
    EXCEPTION WHEN OTHERS THEN
        RETURN jsonb_build_object('valid', false, 'unconfigured', true, 'error', 'School roster data is invalid or corrupt in database.');
    END;

    -- 4. If no matching candidate is found
    IF v_matched IS NULL THEN
        RETURN jsonb_build_object(
            'valid', false,
            'error', 'Candidate "' || TRIM(p_name) || '" was not found in the school roster' || 
                     CASE WHEN v_clean_class <> '' THEN ' for class ' || TRIM(p_class) ELSE '' END || 
                     '. Please check your spelling or verify with your teacher.'
        );
    END IF;

    -- 5. Verify PIN
    IF TRIM(COALESCE(v_matched->>'pin', '')) <> v_clean_pin THEN
        RETURN jsonb_build_object(
            'valid', false,
            'error', '❌ Incorrect 4-digit PIN for ' || (v_matched->>'name') || '. Please verify with your teacher.'
        );
    END IF;

    -- 6. Valid! Return sanitized student profile (EXCLUDING PIN)
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

-- 2. Function to fetch public student directory (WITHOUT PINS) for autocomplete
CREATE OR REPLACE FUNCTION get_public_roster_directory()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_roster_json TEXT;
    v_result JSONB;
BEGIN
    SELECT value INTO v_roster_json FROM app_config WHERE key = 'school_roster' LIMIT 1;
    IF v_roster_json IS NULL OR v_roster_json = '' OR v_roster_json = '[]' THEN
        RETURN '[]'::jsonb;
    END IF;

    BEGIN
        SELECT COALESCE(
            jsonb_agg(
                jsonb_build_object(
                    'id', elem->>'id',
                    'name', elem->>'name',
                    'class', elem->>'class',
                    'candidateNumber', elem->>'candidateNumber'
                )
            ),
            '[]'::jsonb
        )
        INTO v_result
        FROM jsonb_array_elements(v_roster_json::jsonb) AS elem;

        RETURN v_result;
    EXCEPTION WHEN OTHERS THEN
        RETURN '[]'::jsonb;
    END;
END;
$$;

-- Grant execute permissions to anon and authenticated roles
GRANT EXECUTE ON FUNCTION verify_student_pin(TEXT, TEXT, TEXT) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION get_public_roster_directory() TO anon, authenticated;
