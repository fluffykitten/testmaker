-- ============================================================================
-- 014: Game Profiles Table — Creative Mode student profiles, avatars, topic mastery, and rewards
-- Run this in your Supabase SQL Editor (Dashboard → SQL Editor → New Query)
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.game_profiles (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    student_id TEXT, -- Optional link to school_roster id
    handle TEXT NOT NULL UNIQUE, -- Student Creative handle (e.g. "QuantumChemist")
    real_name TEXT, -- Real candidate name
    class TEXT NOT NULL DEFAULT 'Grade 10', -- Cohort (e.g. "Grade 10", "10-A")
    pin_hash TEXT NOT NULL, -- SHA-256 hashed 4-digit PIN for cross-device login
    avatar JSONB NOT NULL DEFAULT '{
      "skin": "#ffd8b3",
      "eyes": "curious",
      "hair": "curly_brunette",
      "outfit": "lab_coat",
      "prop": "erlenmeyer_flask",
      "aura": "none"
    }'::jsonb,
    coins INT NOT NULL DEFAULT 50, -- Starter coin purse for avatar customization
    xp INT NOT NULL DEFAULT 0,
    level INT NOT NULL DEFAULT 1,
    unlocked_items JSONB NOT NULL DEFAULT '["default_lab_coat", "erlenmeyer_flask"]'::jsonb,
    topic_mastery JSONB NOT NULL DEFAULT '{}'::jsonb, -- Partitioned by subject: { "Chemistry": { "Stoichiometry": { "correct": 8, "total": 10, "masteryPct": 80 } } }
    match_history JSONB NOT NULL DEFAULT '[]'::jsonb, -- Recent matches array
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

COMMENT ON TABLE public.game_profiles IS 'Creative Mode student profiles, parametric avatars, coin economy, and subject-partitioned mastery.';

-- Index for speedy handle lookups and class directory queries
CREATE INDEX IF NOT EXISTS idx_game_profiles_handle ON public.game_profiles(LOWER(handle));
CREATE INDEX IF NOT EXISTS idx_game_profiles_class ON public.game_profiles(class);

-- Allow client read/write via anon key
ALTER TABLE public.game_profiles DISABLE ROW LEVEL SECURITY;

-- 1. RPC: Register or Login Game Profile
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
AS $$
DECLARE
    v_clean_handle TEXT := LOWER(TRIM(p_handle));
    v_existing RECORD;
    v_new_id UUID;
    v_avatar JSONB;
BEGIN
    IF v_clean_handle = '' THEN
        RETURN jsonb_build_object('success', false, 'error', 'Creative handle is required.');
    END IF;

    SELECT * INTO v_existing FROM public.game_profiles WHERE LOWER(handle) = v_clean_handle LIMIT 1;

    IF v_existing.id IS NOT NULL THEN
        -- Profile exists: verify PIN hash
        IF v_existing.pin_hash = p_pin_hash THEN
            RETURN jsonb_build_object(
                'success', true,
                'action', 'login',
                'profile', row_to_json(v_existing)
            );
        ELSE
            RETURN jsonb_build_object('success', false, 'error', 'Incorrect 4-digit PIN for this handle.');
        END IF;
    ELSE
        -- Profile does not exist: create new student account
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
            TRIM(p_handle),
            NULLIF(TRIM(COALESCE(p_real_name, '')), ''),
            COALESCE(NULLIF(TRIM(p_class), ''), 'Grade 10'),
            p_pin_hash,
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
            'success', true,
            'action', 'register',
            'profile', row_to_json(v_existing)
        );
    END IF;
END;
$$;

-- 2. RPC: Award match rewards and update topic mastery
CREATE OR REPLACE FUNCTION public.sync_game_match_rewards(
    p_profile_id UUID,
    p_coins INT,
    p_xp INT,
    p_subject TEXT,
    p_topic_results JSONB, -- Array of { "topic": "Acids", "correct": true }
    p_match_summary JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_profile RECORD;
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
BEGIN
    SELECT * INTO v_profile FROM public.game_profiles WHERE id = p_profile_id;
    IF v_profile.id IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'Profile not found.');
    END IF;

    -- Update XP and calculate level (each level requires 150 XP)
    v_new_xp := v_profile.xp + GREATEST(0, p_xp);
    v_new_level := 1 + FLOOR(v_new_xp / 150);

    -- Update topic mastery
    v_mastery := COALESCE(v_profile.topic_mastery, '{}'::jsonb);
    v_subj_mastery := COALESCE(v_mastery->p_subject, '{}'::jsonb);

    IF p_topic_results IS NOT NULL AND jsonb_typeof(p_topic_results) = 'array' THEN
        FOR v_item IN SELECT * FROM jsonb_array_elements(p_topic_results)
        LOOP
            v_topic := TRIM(COALESCE(v_item->>'topic', 'General'));
            v_correct := COALESCE((v_item->>'correct')::boolean, false);
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

    v_mastery := jsonb_set(v_mastery, ARRAY[p_subject], v_subj_mastery);

    -- Append to recent match history (keep latest 20 matches)
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

    -- Update record
    UPDATE public.game_profiles
    SET coins = v_profile.coins + GREATEST(0, p_coins),
        xp = v_new_xp,
        level = v_new_level,
        topic_mastery = v_mastery,
        match_history = v_history,
        updated_at = NOW()
    WHERE id = p_profile_id;

    SELECT * INTO v_profile FROM public.game_profiles WHERE id = p_profile_id;
    RETURN jsonb_build_object('success', true, 'profile', row_to_json(v_profile));
END;
$$;
