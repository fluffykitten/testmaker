-- ============================================================================
-- Migration 023: Proctoring Security & Unlock PIN Parity
-- ============================================================================
-- Hardens live exam proctoring against unauthenticated Realtime command
-- spoofing and aligns `verify_teacher_unlock_pin` lookup parity with `022`:
--   1. Aligns `verify_teacher_unlock_pin` with `get_student_exam_paper`: checks
--      `quiz_by_code_<CODE>` first, then `published_quizzes` matching either
--      `quizCode` or `previousCodes`, and supports `headerConfig->>'teacherPin'`.
--   2. Adds `proctor_channel_keys` table + `register_proctor_public_key` /
--      `get_proctor_public_key` RPCs so live invigilator commands are signed
--      with ephemeral WebCrypto ECDSA P-256 keys held only in teacher memory.
--   3. Removes any leftover synthetic `DIAG%` diagnostic audit rows.
-- ============================================================================

-- ─── 1. Unlock PIN Verification Parity (`019` -> `023`) ───────────────────────

CREATE OR REPLACE FUNCTION public.verify_teacher_unlock_pin(
    p_quiz_code TEXT,
    p_pin TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_code TEXT := UPPER(TRIM(COALESCE(p_quiz_code, '')));
    v_pin TEXT := TRIM(COALESCE(p_pin, ''));
    v_quiz JSONB := NULL;
    v_quizzes JSONB;
    v_stored TEXT;
BEGIN
    IF v_code = '' OR v_pin = '' THEN
        RETURN FALSE;
    END IF;

    -- 1. Primary lookup: fast per-code shard `quiz_by_code_<CODE>`
    BEGIN
        SELECT value::jsonb INTO v_quiz
        FROM public.app_config
        WHERE key = 'quiz_by_code_' || v_code
        LIMIT 1;
    EXCEPTION WHEN OTHERS THEN
        v_quiz := NULL;
    END;

    -- 2. Fallback lookup: `published_quizzes` matching `quizCode` OR `previousCodes`
    IF v_quiz IS NULL THEN
        BEGIN
            SELECT value::jsonb INTO v_quizzes
            FROM public.app_config
            WHERE key = 'published_quizzes'
            LIMIT 1;

            IF v_quizzes IS NOT NULL AND jsonb_typeof(v_quizzes) = 'array' THEN
                SELECT elem INTO v_quiz
                FROM jsonb_array_elements(v_quizzes) AS elem
                WHERE UPPER(TRIM(COALESCE(elem->>'quizCode', ''))) = v_code
                   OR EXISTS (
                       SELECT 1
                       FROM jsonb_array_elements_text(
                           CASE
                               WHEN jsonb_typeof(elem->'previousCodes') = 'array' THEN elem->'previousCodes'
                               ELSE '[]'::jsonb
                           END
                       ) AS prev_code
                       WHERE UPPER(TRIM(prev_code)) = v_code
                   )
                LIMIT 1;
            END IF;
        EXCEPTION WHEN OTHERS THEN
            v_quiz := NULL;
        END;
    END IF;

    IF v_quiz IS NULL THEN
        RETURN FALSE;
    END IF;

    v_stored := COALESCE(
        NULLIF(TRIM(v_quiz->>'teacherPin'), ''),
        NULLIF(TRIM(v_quiz->'headerConfig'->>'teacherPin'), '')
    );

    RETURN v_stored IS NOT NULL AND v_stored = v_pin;
EXCEPTION WHEN OTHERS THEN
    RETURN FALSE;
END;
$$;

-- ─── 2. Signed Live Proctor Command Keys (ECDSA P-256 Public Registry) ───────

CREATE TABLE IF NOT EXISTS public.proctor_channel_keys (
    quiz_code TEXT NOT NULL,
    key_id TEXT NOT NULL,
    public_jwk JSONB NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '24 hours'),
    PRIMARY KEY (quiz_code, key_id)
);

CREATE INDEX IF NOT EXISTS idx_proctor_channel_keys_expires
    ON public.proctor_channel_keys (expires_at);

REVOKE ALL ON public.proctor_channel_keys FROM anon, authenticated;
ALTER TABLE public.proctor_channel_keys ENABLE ROW LEVEL SECURITY;

-- Invigilator registers an ephemeral ECDSA P-256 public key (private key stays
-- non-extractable in the invigilator browser tab).
CREATE OR REPLACE FUNCTION public.register_proctor_public_key(
    p_quiz_code TEXT,
    p_key_id TEXT,
    p_public_jwk JSONB
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_code TEXT := UPPER(TRIM(COALESCE(p_quiz_code, '')));
    v_key_id TEXT := TRIM(COALESCE(p_key_id, ''));
BEGIN
    IF NOT public.is_authenticated_teacher() THEN
        RAISE EXCEPTION 'Invigilator authentication required to register proctor signing keys.'
            USING ERRCODE = '42501';
    END IF;

    IF LENGTH(v_code) NOT BETWEEN 2 AND 32 OR LENGTH(v_key_id) NOT BETWEEN 8 AND 80 THEN
        RAISE EXCEPTION 'Invalid quiz code or key id.' USING ERRCODE = '22023';
    END IF;

    IF p_public_jwk IS NULL
       OR jsonb_typeof(p_public_jwk) <> 'object'
       OR COALESCE(p_public_jwk->>'kty', '') <> 'EC'
       OR COALESCE(p_public_jwk->>'crv', '') <> 'P-256'
       OR COALESCE(p_public_jwk->>'x', '') = ''
       OR COALESCE(p_public_jwk->>'y', '') = ''
       OR (p_public_jwk ? 'd') THEN
        RAISE EXCEPTION 'Invalid ECDSA P-256 public JWK payload.' USING ERRCODE = '22023';
    END IF;

    DELETE FROM public.proctor_channel_keys
    WHERE expires_at < NOW() - INTERVAL '1 hour';

    INSERT INTO public.proctor_channel_keys (
        quiz_code,
        key_id,
        public_jwk,
        is_active,
        created_at,
        expires_at
    )
    VALUES (
        v_code,
        v_key_id,
        jsonb_build_object(
            'kty', 'EC',
            'crv', 'P-256',
            'x', p_public_jwk->>'x',
            'y', p_public_jwk->>'y',
            'ext', TRUE
        ),
        TRUE,
        NOW(),
        NOW() + INTERVAL '24 hours'
    )
    ON CONFLICT (quiz_code, key_id) DO UPDATE
    SET public_jwk = EXCLUDED.public_jwk,
        is_active = TRUE,
        expires_at = EXCLUDED.expires_at;

    RETURN TRUE;
END;
$$;

-- Student clients look up the invigilator public JWK to verify broadcast commands.
CREATE OR REPLACE FUNCTION public.get_proctor_public_key(
    p_quiz_code TEXT,
    p_key_id TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_code TEXT := UPPER(TRIM(COALESCE(p_quiz_code, '')));
    v_key_id TEXT := TRIM(COALESCE(p_key_id, ''));
    v_row RECORD;
BEGIN
    IF v_code = '' OR v_key_id = '' THEN
        RETURN jsonb_build_object('found', FALSE);
    END IF;

    SELECT public_jwk, is_active
    INTO v_row
    FROM public.proctor_channel_keys
    WHERE quiz_code = v_code
      AND key_id = v_key_id
      AND is_active = TRUE
      AND expires_at > NOW()
    LIMIT 1;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('found', FALSE);
    END IF;

    RETURN jsonb_build_object(
        'found', TRUE,
        'publicJwk', v_row.public_jwk,
        'isActive', v_row.is_active
    );
EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('found', FALSE);
END;
$$;

-- ─── 3. Clean Leftover Synthetic Diagnostic Audit Rows ───────────────────────

DELETE FROM public.proctor_audit_events
WHERE quiz_code LIKE 'DIAG%';

-- ─── 4. Permissions ──────────────────────────────────────────────────────────

GRANT EXECUTE ON FUNCTION public.verify_teacher_unlock_pin(TEXT, TEXT) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.register_proctor_public_key(TEXT, TEXT, JSONB) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_proctor_public_key(TEXT, TEXT) TO anon, authenticated;

