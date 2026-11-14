-- ============================================================================
-- Migration 020: Server-side verification RPC for Teacher Access PIN (PinGate)
-- ============================================================================
-- Replaces client-side fetching & caching of `app_config.access_pin` so a
-- student browser never downloads the teacher PIN or falls back to fail-open
-- offline access.
-- ============================================================================

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
    v_stored  TEXT;
    v_hash    TEXT;
BEGIN
    IF v_entered = '' THEN
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

    -- 64-character SHA-256 hex digest format
    IF LENGTH(v_stored) = 64 AND v_stored ~ '^[0-9a-fA-F]{64}$' THEN
        RETURN v_hash = LOWER(v_stored);
    END IF;

    -- Legacy plaintext match or fallback hash match
    RETURN v_entered = v_stored OR v_hash = LOWER(v_stored);
EXCEPTION WHEN OTHERS THEN
    RETURN FALSE;
END;
$$;

REVOKE ALL ON FUNCTION public.verify_teacher_access_pin(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.verify_teacher_access_pin(TEXT) TO anon, authenticated;

