-- ============================================================================
-- Migration 034: Atomic Draft-Lock Upsert, Normalized Submission Index, &
--                Class-Normalized Join PIN Rate Limiting
-- ============================================================================
-- Resolves the three remaining gaps identified in live 200-student stress test:
--   1. Expression index `idx_quiz_submissions_code_norm_name_class` matching
--      the exact `REGEXP_REPLACE` normalized name predicate used by
--      `check_student_attempt_submitted` and `submit_student_exam_attempt`.
--   2. Atomic conditional `ON CONFLICT (draft_key) DO UPDATE ... WHERE ...`
--      inside `save_student_exam_draft` so simultaneous first-write lock races
--      are mutually exclusive (preserving the 10-minute lock-write skip).
--   3. Re-applies class-normalized `verify_student_pin` (`normalize_roster_class_label`)
--      so mixed class formatting (e.g. 'X IPA 3' vs '10-IPA-03') shares one
--      rate-limit bucket.
-- ============================================================================

-- ─── 1. Normalized Class Helper & Matching Submission Index ──────────────────

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

CREATE INDEX IF NOT EXISTS idx_quiz_submissions_code_norm_name_class
    ON public.quiz_submissions (
        UPPER(TRIM(quiz_code)),
        LOWER(REGEXP_REPLACE(TRIM(COALESCE(student_name, '')), '\s+', ' ', 'g')),
        public.normalize_roster_class_label(student_class)
    );

ANALYZE public.quiz_submissions;

-- ─── 2. Atomic `save_student_exam_draft` Lock Acquisition ────────────────────

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
    v_lock_acquired BOOLEAN := FALSE;
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
            updated_at = NOW()
        WHERE public.exam_draft_locks.owner_token_hash = EXCLUDED.owner_token_hash
           OR public.exam_draft_locks.updated_at IS NULL
           OR public.exam_draft_locks.updated_at <= (NOW() - INTERVAL '24 hours')
        RETURNING TRUE INTO v_lock_acquired;

        IF NOT COALESCE(v_lock_acquired, FALSE) THEN
            RETURN FALSE;
        END IF;
    END IF;

    -- Schema of app_config is (key, value) only — never reference updated_at here
    INSERT INTO public.app_config (key, value)
    VALUES (p_key, COALESCE(p_value, ''))
    ON CONFLICT (key) DO UPDATE
    SET value = EXCLUDED.value;

    RETURN TRUE;
END;
$$;

GRANT EXECUTE ON FUNCTION public.save_student_exam_draft(TEXT, TEXT, TEXT) TO anon, authenticated;

-- ─── 3. Class-Normalized `verify_student_pin` Rate-Limit Scope ───────────────

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

GRANT EXECUTE ON FUNCTION public.verify_student_pin(TEXT, TEXT, TEXT) TO anon, authenticated;
