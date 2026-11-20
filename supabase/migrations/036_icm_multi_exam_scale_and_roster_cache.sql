-- ============================================================================
-- Migration 036: Multi-Exam Real-Student Scale Hardening (ICM-1..ICM-13) &
--                Indexed School Roster Cache
-- ============================================================================
-- Resolves the Postgres CPU, lock-queue, and rate-limit write bottlenecks
-- discovered during the 13-exam (`ICM-1`..`ICM-13`, `requireStudentPin = true`)
-- real-student live stress test:
--   1. Drops redundant `idx_quiz_submissions_attempt_class_lookup` (031),
--      keeping 034's `idx_quiz_submissions_code_norm_name_class`.
--   2. Optimizes `clear_rate_limit(p_scope_key)` to check `IF EXISTS` by
--      Primary Key and delete only `WHERE scope_key = p_scope_key`, removing
--      the write transaction + `OR locked_until < ...` full-table scan from
--      every valid student PIN login.
--   3. Creates private, RLS-locked `school_roster_entries` + `school_roster_meta`
--      cache tables synced automatically by trigger on `app_config`
--      (`key = 'school_roster'`), and upgrades `get_public_roster_directory()`,
--      `verify_student_pin(...)`, and `verify_roster_pin_if_enrolled(...)`
--      (called inside `submit_student_exam_attempt` when `requireStudentPin=true`)
--      to use B-tree indexed lookups instead of parsing `school_roster` JSONB
--      on every lobby load, login, and submission.
--   4. Upgrades `invalidate_exam_paper_cache_on_config()` so updating
--      `published_quizzes` only invalidates `exam_paper_cache` rows whose quiz
--      entry actually changed or was removed (preserving the other 12 cached
--      exams during `ICM-1`..`ICM-13`).
--   5. Upgrades `get_student_exam_paper(p_code)` so non-active
--      (`paused`/`scheduled`/`closed`) quizzes return before acquiring
--      `pg_advisory_xact_lock` and only delete from `exam_paper_cache` when a
--      cached row actually exists.
--   6. Guards expired key cleanup in `register_proctor_public_key` with
--      `IF EXISTS (...)` so opening a 13-exam Live Proctor Cockpit does not run
--      13 redundant DELETE scans.
-- ============================================================================

-- ─── 1. Drop Redundant Functional Submission Index ───────────────────────────

DROP INDEX IF EXISTS public.idx_quiz_submissions_attempt_class_lookup;

-- ─── 2. Contention-Free `clear_rate_limit` on Valid Student Logins ───────────

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

    -- Read-only PK probe first: 99% of valid student logins have no failure row
    -- and should perform zero heap/WAL writes.
    IF EXISTS (
        SELECT 1
        FROM public.security_rate_limits
        WHERE scope_key = p_scope_key
    ) THEN
        DELETE FROM public.security_rate_limits
        WHERE scope_key = p_scope_key;
    END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.clear_rate_limit(TEXT) FROM PUBLIC, anon, authenticated;

-- ─── 3. Trigger-Maintained School Roster Cache Tables & RPCs ─────────────────

CREATE TABLE IF NOT EXISTS public.school_roster_entries (
    ord INT PRIMARY KEY,
    student_id TEXT NOT NULL,
    student_name TEXT NOT NULL,
    norm_name TEXT NOT NULL,
    student_class TEXT NOT NULL DEFAULT '',
    norm_class TEXT NOT NULL DEFAULT '',
    candidate_number TEXT NULL,
    pin TEXT NOT NULL DEFAULT ''
) WITH (fillfactor = 80);

CREATE INDEX IF NOT EXISTS idx_school_roster_entries_norm_lookup
    ON public.school_roster_entries (norm_name, norm_class, ord);

ALTER TABLE public.school_roster_entries ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.school_roster_entries FROM PUBLIC, anon, authenticated;

CREATE TABLE IF NOT EXISTS public.school_roster_meta (
    singleton_id INT PRIMARY KEY DEFAULT 1,
    is_configured BOOLEAN NOT NULL DEFAULT FALSE,
    is_corrupt BOOLEAN NOT NULL DEFAULT FALSE,
    entry_count INT NOT NULL DEFAULT 0,
    public_directory JSONB NOT NULL DEFAULT '[]'::jsonb,
    synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT school_roster_meta_singleton CHECK (singleton_id = 1)
) WITH (fillfactor = 70);

ALTER TABLE public.school_roster_meta ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.school_roster_meta FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.rebuild_school_roster_cache()
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_roster_json TEXT;
    v_parsed JSONB;
    v_public_dir JSONB := '[]'::jsonb;
    v_count INT := 0;
BEGIN
    DELETE FROM public.school_roster_entries WHERE ord IS NOT NULL;

    SELECT value INTO v_roster_json
    FROM public.app_config
    WHERE key = 'school_roster'
    LIMIT 1;

    IF v_roster_json IS NULL OR TRIM(v_roster_json) = '' OR TRIM(v_roster_json) = '[]' THEN
        INSERT INTO public.school_roster_meta (
            singleton_id, is_configured, is_corrupt, entry_count, public_directory, synced_at
        )
        VALUES (1, FALSE, FALSE, 0, '[]'::jsonb, NOW())
        ON CONFLICT (singleton_id) DO UPDATE
        SET is_configured = FALSE,
            is_corrupt = FALSE,
            entry_count = 0,
            public_directory = '[]'::jsonb,
            synced_at = NOW();
        RETURN;
    END IF;

    BEGIN
        v_parsed := v_roster_json::jsonb;
        IF jsonb_typeof(v_parsed) <> 'array' OR jsonb_array_length(v_parsed) = 0 THEN
            INSERT INTO public.school_roster_meta (
                singleton_id, is_configured, is_corrupt, entry_count, public_directory, synced_at
            )
            VALUES (1, FALSE, jsonb_typeof(v_parsed) <> 'array', 0, '[]'::jsonb, NOW())
            ON CONFLICT (singleton_id) DO UPDATE
            SET is_configured = EXCLUDED.is_configured,
                is_corrupt = EXCLUDED.is_corrupt,
                entry_count = 0,
                public_directory = '[]'::jsonb,
                synced_at = NOW();
            RETURN;
        END IF;

        INSERT INTO public.school_roster_entries (
            ord, student_id, student_name, norm_name, student_class, norm_class, candidate_number, pin
        )
        SELECT
            arr.ord::int,
            COALESCE(arr.elem->>'id', ''),
            COALESCE(arr.elem->>'name', ''),
            LOWER(REGEXP_REPLACE(TRIM(COALESCE(arr.elem->>'name', '')), '\s+', ' ', 'g')),
            COALESCE(arr.elem->>'class', ''),
            public.normalize_roster_class_label(arr.elem->>'class'),
            arr.elem->>'candidateNumber',
            TRIM(COALESCE(arr.elem->>'pin', ''))
        FROM jsonb_array_elements(v_parsed) WITH ORDINALITY AS arr(elem, ord);

        GET DIAGNOSTICS v_count = ROW_COUNT;

        SELECT COALESCE(
            jsonb_agg(
                jsonb_build_object(
                    'id', e.student_id,
                    'name', e.student_name,
                    'class', e.student_class,
                    'candidateNumber', e.candidate_number
                )
                ORDER BY e.ord ASC
            ),
            '[]'::jsonb
        )
        INTO v_public_dir
        FROM public.school_roster_entries e;

        INSERT INTO public.school_roster_meta (
            singleton_id, is_configured, is_corrupt, entry_count, public_directory, synced_at
        )
        VALUES (1, v_count > 0, FALSE, v_count, v_public_dir, NOW())
        ON CONFLICT (singleton_id) DO UPDATE
        SET is_configured = EXCLUDED.is_configured,
            is_corrupt = FALSE,
            entry_count = EXCLUDED.entry_count,
            public_directory = EXCLUDED.public_directory,
            synced_at = NOW();
    EXCEPTION WHEN OTHERS THEN
        DELETE FROM public.school_roster_entries WHERE ord IS NOT NULL;
        INSERT INTO public.school_roster_meta (
            singleton_id, is_configured, is_corrupt, entry_count, public_directory, synced_at
        )
        VALUES (1, FALSE, TRUE, 0, '[]'::jsonb, NOW())
        ON CONFLICT (singleton_id) DO UPDATE
        SET is_configured = FALSE,
            is_corrupt = TRUE,
            entry_count = 0,
            public_directory = '[]'::jsonb,
            synced_at = NOW();
    END;
END;
$$;

REVOKE ALL ON FUNCTION public.rebuild_school_roster_cache() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.trg_sync_school_roster_cache()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    PERFORM public.rebuild_school_roster_cache();
    RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.trg_sync_school_roster_cache() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_sync_school_roster_cache_iu ON public.app_config;
CREATE TRIGGER trg_sync_school_roster_cache_iu
    AFTER INSERT OR UPDATE ON public.app_config
    FOR EACH ROW
    WHEN (NEW.key = 'school_roster')
    EXECUTE FUNCTION public.trg_sync_school_roster_cache();

DROP TRIGGER IF EXISTS trg_sync_school_roster_cache_d ON public.app_config;
CREATE TRIGGER trg_sync_school_roster_cache_d
    AFTER DELETE ON public.app_config
    FOR EACH ROW
    WHEN (OLD.key = 'school_roster')
    EXECUTE FUNCTION public.trg_sync_school_roster_cache();

-- Build cache immediately upon migration execution
SELECT public.rebuild_school_roster_cache();

CREATE OR REPLACE FUNCTION public.get_public_roster_directory()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_dir JSONB;
BEGIN
    SELECT public_directory
    INTO v_dir
    FROM public.school_roster_meta
    WHERE singleton_id = 1
    LIMIT 1;

    IF NOT FOUND THEN
        PERFORM public.rebuild_school_roster_cache();
        SELECT public_directory
        INTO v_dir
        FROM public.school_roster_meta
        WHERE singleton_id = 1
        LIMIT 1;
    END IF;

    RETURN COALESCE(v_dir, '[]'::jsonb);
EXCEPTION WHEN OTHERS THEN
    RETURN '[]'::jsonb;
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

-- ─── 4. Selective `exam_paper_cache` Invalidation on `published_quizzes` ─────

CREATE OR REPLACE FUNCTION public.invalidate_exam_paper_cache_on_config()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_key TEXT := CASE WHEN TG_OP = 'DELETE' THEN COALESCE(OLD.key, '') ELSE COALESCE(NEW.key, '') END;
    v_old_arr JSONB;
    v_new_arr JSONB;
BEGIN
    IF v_key LIKE 'quiz_by_code_%' OR v_key LIKE 'quiz_by_code:%' THEN
        DELETE FROM public.exam_paper_cache
        WHERE quiz_code = UPPER(TRIM(SUBSTRING(v_key FROM 14)));
    ELSIF v_key = 'published_quizzes' THEN
        IF TG_OP = 'UPDATE' THEN
            BEGIN
                v_old_arr := COALESCE(OLD.value, '[]')::jsonb;
                v_new_arr := COALESCE(NEW.value, '[]')::jsonb;
                IF jsonb_typeof(v_old_arr) = 'array' AND jsonb_typeof(v_new_arr) = 'array' THEN
                    -- Only invalidate cached quiz codes whose entry in published_quizzes actually changed or was removed
                    DELETE FROM public.exam_paper_cache c
                    WHERE c.quiz_code IS NOT NULL
                      AND NOT EXISTS (
                          SELECT 1
                          FROM jsonb_array_elements(v_old_arr) o
                          JOIN jsonb_array_elements(v_new_arr) n
                            ON UPPER(TRIM(COALESCE(o->>'quizCode', ''))) = UPPER(TRIM(COALESCE(n->>'quizCode', '')))
                          WHERE UPPER(TRIM(COALESCE(n->>'quizCode', ''))) = c.quiz_code
                            AND o = n
                      );
                    RETURN NULL;
                END IF;
            EXCEPTION WHEN OTHERS THEN
                -- Fall through to full cache clear if JSON parsing fails
            END;
        END IF;
        DELETE FROM public.exam_paper_cache
        WHERE quiz_code IS NOT NULL;
    ELSIF v_key LIKE 'custom_test_header_%'
       OR v_key LIKE 'test_header_%'
       OR v_key IN ('school_classes', 'exam_security_tiers', 'hide_emergency_exam_button') THEN
        DELETE FROM public.exam_paper_cache
        WHERE quiz_code IS NOT NULL;
    END IF;
    RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.invalidate_exam_paper_cache_on_config() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_invalidate_exam_paper_cache_app_config_iu ON public.app_config;
CREATE TRIGGER trg_invalidate_exam_paper_cache_app_config_iu
    AFTER INSERT OR UPDATE ON public.app_config
    FOR EACH ROW
    WHEN (
        NEW.key LIKE 'quiz_by_code_%'
        OR NEW.key LIKE 'quiz_by_code:%'
        OR NEW.key = 'published_quizzes'
        OR NEW.key LIKE 'custom_test_header_%'
        OR NEW.key LIKE 'test_header_%'
        OR NEW.key IN ('school_classes', 'exam_security_tiers', 'hide_emergency_exam_button')
    )
    EXECUTE FUNCTION public.invalidate_exam_paper_cache_on_config();

DROP TRIGGER IF EXISTS trg_invalidate_exam_paper_cache_app_config_d ON public.app_config;
CREATE TRIGGER trg_invalidate_exam_paper_cache_app_config_d
    AFTER DELETE ON public.app_config
    FOR EACH ROW
    WHEN (
        OLD.key LIKE 'quiz_by_code_%'
        OR OLD.key LIKE 'quiz_by_code:%'
        OR OLD.key = 'published_quizzes'
        OR OLD.key LIKE 'custom_test_header_%'
        OR OLD.key LIKE 'test_header_%'
        OR OLD.key IN ('school_classes', 'exam_security_tiers', 'hide_emergency_exam_button')
    )
    EXECUTE FUNCTION public.invalidate_exam_paper_cache_on_config();

-- ─── 5. Non-Locking Non-Active (`paused`/`scheduled`/`closed`) Paper Reads ───

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
    v_now TIMESTAMPTZ := NOW();
    v_cached_payload JSONB;
    v_raw TEXT;
    v_quiz JSONB;
    v_is_active BOOLEAN;
    v_quiz_mode TEXT;
    v_scheduled_start TIMESTAMPTZ := NULL;
    v_scheduled_end TIMESTAMPTZ := NULL;
    v_schedule_status TEXT := 'active';
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
    v_school_classes JSONB := NULL;
    v_security_tiers JSONB := NULL;
    v_hide_emergency_btn BOOLEAN := NULL;
    v_cfg_row RECORD;
    v_result JSONB;
BEGIN
    IF v_code = '' THEN
        RETURN NULL;
    END IF;

    -- Fast path: return cached active paper immediately if still within live schedule bounds
    SELECT c.payload
    INTO v_cached_payload
    FROM public.exam_paper_cache c
    WHERE c.quiz_code = v_code
      AND c.cached_at > (v_now - INTERVAL '5 minutes')
      AND (c.scheduled_start_at IS NULL OR v_now >= c.scheduled_start_at)
      AND (c.scheduled_end_at IS NULL OR v_now <= c.scheduled_end_at)
    LIMIT 1;

    IF FOUND AND v_cached_payload IS NOT NULL THEN
        RETURN v_cached_payload || jsonb_build_object(
            'scheduleStatus', 'active',
            'serverNow', v_now,
            'publicRosterDirectory', public.get_public_roster_directory()
        );
    END IF;

    -- Resolve quiz metadata before acquiring advisory lock so paused/scheduled/closed
    -- waiting-room polls never serialize behind pg_advisory_xact_lock or issue redundant DELETE writes.
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
    v_quiz_mode := LOWER(COALESCE(NULLIF(TRIM(v_quiz->>'quizMode'), ''), 'exam'));

    IF NULLIF(TRIM(COALESCE(v_quiz->>'scheduledStartAt', '')), '') IS NOT NULL THEN
        BEGIN
            v_scheduled_start := (v_quiz->>'scheduledStartAt')::timestamptz;
        EXCEPTION WHEN OTHERS THEN
            v_scheduled_start := NULL;
        END;
    END IF;

    IF NULLIF(TRIM(COALESCE(v_quiz->>'scheduledEndAt', '')), '') IS NOT NULL THEN
        BEGIN
            v_scheduled_end := (v_quiz->>'scheduledEndAt')::timestamptz;
        EXCEPTION WHEN OTHERS THEN
            v_scheduled_end := NULL;
        END;
    END IF;

    IF NOT v_is_active THEN
        v_schedule_status := 'paused';
    ELSIF v_quiz_mode <> 'game' THEN
        IF v_scheduled_start IS NOT NULL AND v_now < v_scheduled_start THEN
            v_schedule_status := 'scheduled';
        ELSIF v_scheduled_end IS NOT NULL AND v_now > v_scheduled_end THEN
            v_schedule_status := 'closed';
        ELSE
            v_schedule_status := 'active';
        END IF;
    ELSE
        v_schedule_status := 'active';
    END IF;

    IF v_schedule_status <> 'active' THEN
        IF EXISTS (
            SELECT 1
            FROM public.exam_paper_cache
            WHERE quiz_code = v_code
        ) THEN
            DELETE FROM public.exam_paper_cache WHERE quiz_code = v_code;
        END IF;
        RETURN jsonb_build_object(
            'publishedQuiz', v_quiz,
            'teacherPinHash', NULL,
            'isActive', FALSE,
            'scheduleStatus', v_schedule_status,
            'serverNow', v_now,
            'questions', '[]'::jsonb
        );
    END IF;

    -- Single-flight per-code build for active exam papers only
    PERFORM pg_advisory_xact_lock(hashtext('exam_paper_cache:' || v_code));
    v_now := NOW();

    -- Re-check cache after acquiring lock (workers #2..#200 return right away)
    SELECT c.payload
    INTO v_cached_payload
    FROM public.exam_paper_cache c
    WHERE c.quiz_code = v_code
      AND c.cached_at > (v_now - INTERVAL '5 minutes')
      AND (c.scheduled_start_at IS NULL OR v_now >= c.scheduled_start_at)
      AND (c.scheduled_end_at IS NULL OR v_now <= c.scheduled_end_at)
    LIMIT 1;

    IF FOUND AND v_cached_payload IS NOT NULL THEN
        RETURN v_cached_payload || jsonb_build_object(
            'scheduleStatus', 'active',
            'serverNow', v_now,
            'publicRosterDirectory', public.get_public_roster_directory()
        );
    END IF;

    v_test_id := TRIM(COALESCE(v_quiz->>'testId', ''));
    IF v_test_id <> '' THEN
        IF v_test_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
            SELECT id, title, total_marks, question_ids, created_at
            INTO v_test_row
            FROM public.custom_tests
            WHERE id = v_test_id::uuid
            LIMIT 1;
        ELSE
            SELECT id, title, total_marks, question_ids, created_at
            INTO v_test_row
            FROM public.custom_tests
            WHERE id::text = v_test_id
            LIMIT 1;
        END IF;

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
        WITH ordered_qids AS (
            SELECT
                u.ord,
                u.qid,
                CASE
                    WHEN u.qid ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                        THEN u.qid::uuid
                    ELSE NULL
                END AS q_uuid
            FROM unnest(v_qids) WITH ORDINALITY AS u(qid, ord)
        ),
        matched_questions AS (
            SELECT q.*
            FROM public.questions q
            WHERE q.id IN (SELECT o.q_uuid FROM ordered_qids o WHERE o.q_uuid IS NOT NULL)
        )
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
                o.ord,
                CASE
                    WHEN (v_overrides ? o.qid) AND jsonb_typeof(v_overrides->o.qid) = 'object' THEN
                        COALESCE(to_jsonb(q), '{}'::jsonb) || (v_overrides->o.qid)
                    ELSE to_jsonb(q)
                END AS merged_q
            FROM ordered_qids o
            LEFT JOIN matched_questions q ON q.id = o.q_uuid
        ) sub
        WHERE merged_q IS NOT NULL;
    END IF;

    FOR v_cfg_row IN
        SELECT key, value
        FROM public.app_config
        WHERE key IN ('school_classes', 'exam_security_tiers', 'hide_emergency_exam_button')
    LOOP
        IF v_cfg_row.value IS NOT NULL AND TRIM(v_cfg_row.value) <> '' THEN
            BEGIN
                IF v_cfg_row.key = 'school_classes' AND jsonb_typeof(v_cfg_row.value::jsonb) = 'array' THEN
                    v_school_classes := v_cfg_row.value::jsonb;
                ELSIF v_cfg_row.key = 'exam_security_tiers' AND jsonb_typeof(v_cfg_row.value::jsonb) = 'array' THEN
                    v_security_tiers := v_cfg_row.value::jsonb;
                ELSIF v_cfg_row.key = 'hide_emergency_exam_button' THEN
                    IF LOWER(TRIM(BOTH '"' FROM TRIM(v_cfg_row.value))) = 'true' THEN
                        v_hide_emergency_btn := TRUE;
                    ELSIF LOWER(TRIM(BOTH '"' FROM TRIM(v_cfg_row.value))) = 'false' THEN
                        v_hide_emergency_btn := FALSE;
                    END IF;
                END IF;
            EXCEPTION WHEN OTHERS THEN
                -- Ignore malformed config value
            END;
        END IF;
    END LOOP;

    v_result := jsonb_build_object(
        'publishedQuiz', v_quiz,
        'customTest', v_test_meta,
        'headerConfig', v_header_clean,
        'teacherPinHash', NULL,
        'isActive', TRUE,
        'scheduleStatus', 'active',
        'serverNow', v_now,
        'questions', v_questions,
        'schoolClasses', v_school_classes,
        'securityTiers', v_security_tiers,
        'hideEmergencyExamButton', v_hide_emergency_btn
    );

    INSERT INTO public.exam_paper_cache (
        quiz_code, strip_keys, scheduled_start_at, scheduled_end_at, payload, cached_at
    )
    VALUES (
        v_code,
        v_strip_keys,
        CASE WHEN v_quiz_mode <> 'game' THEN v_scheduled_start ELSE NULL END,
        CASE WHEN v_quiz_mode <> 'game' THEN v_scheduled_end ELSE NULL END,
        v_result,
        NOW()
    )
    ON CONFLICT (quiz_code) DO UPDATE
    SET strip_keys = EXCLUDED.strip_keys,
        scheduled_start_at = EXCLUDED.scheduled_start_at,
        scheduled_end_at = EXCLUDED.scheduled_end_at,
        payload = EXCLUDED.payload,
        cached_at = NOW();

    RETURN v_result || jsonb_build_object(
        'publicRosterDirectory', public.get_public_roster_directory()
    );
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_student_exam_paper(TEXT) TO anon, authenticated;

-- ─── 6. Guard Expired Proctor Key Cleanup With `IF EXISTS` ───────────────────

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

    IF EXISTS (
        SELECT 1
        FROM public.proctor_channel_keys
        WHERE expires_at < NOW() - INTERVAL '1 hour'
        LIMIT 1
    ) THEN
        DELETE FROM public.proctor_channel_keys
        WHERE expires_at < NOW() - INTERVAL '1 hour';
    END IF;

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

GRANT EXECUTE ON FUNCTION public.register_proctor_public_key(TEXT, TEXT, JSONB) TO anon, authenticated;

-- ─── 7. Cache-Accelerated `submit_student_exam_attempt` With Inline Draft Cleanup ─

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

    -- Fast lookup from already-parsed exam_paper_cache before hitting app_config / published_quizzes
    SELECT c.payload->'publishedQuiz'
    INTO v_quiz
    FROM public.exam_paper_cache c
    WHERE c.quiz_code = v_quiz_code
    LIMIT 1;

    IF v_quiz IS NULL THEN
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
    END IF;

    IF v_quiz IS NOT NULL THEN
        v_is_exam_mode := COALESCE((v_quiz->>'isExamMode')::boolean, TRUE);
        v_limit_one_attempt := COALESCE((v_quiz->>'limitOneAttempt')::boolean, TRUE);
        v_require_student_pin := COALESCE((v_quiz->>'requireStudentPin')::boolean, FALSE);
    END IF;

    IF (v_require_student_pin OR v_student_pin <> '') THEN
        IF NOT public.verify_roster_pin_if_enrolled(v_student_name, v_student_class, v_candidate_number, v_student_pin, v_require_student_pin) THEN
            RETURN FALSE;
        END IF;
    END IF;

    v_slug_name := REGEXP_REPLACE(REGEXP_REPLACE(LOWER(TRIM(v_student_name)), '[^a-z0-9]+', '_', 'g'), '^_+|_+$', '', 'g');
    v_slug_class := REGEXP_REPLACE(REGEXP_REPLACE(v_norm_class, '[^a-z0-9]+', '_', 'g'), '^_+|_+$', '', 'g');

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

    IF v_lock_hash IS NULL AND EXISTS (
        SELECT 1
        FROM public.quiz_submissions s
        WHERE s.id = v_id
          AND UPPER(TRIM(s.quiz_code)) = v_quiz_code
          AND LOWER(REGEXP_REPLACE(TRIM(COALESCE(s.student_name, '')), '\s+', ' ', 'g')) = v_norm_name
          AND (
              v_norm_class = ''
              OR COALESCE(TRIM(s.student_class), '') = ''
              OR public.normalize_roster_class_label(s.student_class) = v_norm_class
          )
          AND s.status IN ('submitted', 'graded')
          AND NULLIF(TRIM(s.result_pin), '') IS NULL
    ) THEN
        RETURN TRUE;
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
      AND (
          (
              NULLIF(TRIM(public.quiz_submissions.result_pin), '') IS NOT NULL
              AND TRIM(public.quiz_submissions.result_pin) = v_result_pin
          )
          OR (
              NULLIF(TRIM(public.quiz_submissions.result_pin), '') IS NULL
              AND v_lock_hash IS NOT NULL
              AND UPPER(TRIM(public.quiz_submissions.quiz_code)) = v_quiz_code
              AND LOWER(REGEXP_REPLACE(TRIM(COALESCE(public.quiz_submissions.student_name, '')), '\s+', ' ', 'g')) = v_norm_name
              AND (
                  v_norm_class = ''
                  OR COALESCE(TRIM(public.quiz_submissions.student_class), '') = ''
                  OR public.normalize_roster_class_label(public.quiz_submissions.student_class) = v_norm_class
              )
          )
      );

    GET DIAGNOSTICS v_affected = ROW_COUNT;

    IF v_affected > 0 AND v_draft_key IS NOT NULL AND v_draft_key LIKE 'draft_%' THEN
        DELETE FROM public.app_config WHERE key = v_draft_key;
        DELETE FROM public.exam_draft_locks WHERE draft_key = v_draft_key;
    END IF;

    RETURN v_affected > 0;
EXCEPTION WHEN SQLSTATE '42501' THEN
    RAISE;
WHEN OTHERS THEN
    RETURN FALSE;
END;
$$;

GRANT EXECUTE ON FUNCTION public.submit_student_exam_attempt(JSONB) TO anon, authenticated;

-- Flush stale exam paper cache so new bundled lobby metadata is populated
DELETE FROM public.exam_paper_cache WHERE quiz_code IS NOT NULL;
